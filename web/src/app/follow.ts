const nearBottomPx = 70

export function follow(scroll: HTMLElement, content: HTMLElement, changed: () => void) {
  let following = true
  let atBottom = true
  let seen = scroll.scrollTop
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
    seen = scroll.scrollTop
  }
  const bottom = () => scroll.scrollHeight - scroll.clientHeight
  let pressed = false
  let steered = false
  const left = () => steered && scroll.scrollTop < seen - 1 && distance() > 1
  const selecting = () => pressed && !!getSelection()?.toString()
  const onScroll = () => {
    const top = scroll.scrollTop
    if (left()) report({ following: false })
    else if (steered && !following && top > seen + 1 && distance() <= 1) report({ following: true })
    else report({})
    seen = top
    steered = pressed
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
    if (ownerOf(event.target) !== scroll || !scrollsItself(scroll)) return
    steered = true
    if (event.deltaY < 0) report({ following: false })
  }
  const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
  const typing = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || !!target.closest('input, textarea'))
  const steer = (event: Event) => {
    steered = true
    if (event.type === 'pointerdown') pressed = true
  }
  const onKey = (event: KeyboardEvent) => {
    if (scrollKeys.has(event.key) && !typing(event.target)) steered = true
  }
  const release = () => {
    pressed = false
  }
  const grow = new ResizeObserver(() => {
    if (following && !selecting()) place(bottom())
    report({})
  })
  scroll.addEventListener('scroll', onScroll, { passive: true })
  scroll.addEventListener('wheel', onWheel, { passive: true })
  scroll.addEventListener('pointerdown', steer, { passive: true })
  scroll.addEventListener('touchstart', steer, { passive: true })
  window.addEventListener('pointerup', release, { passive: true })
  window.addEventListener('keydown', onKey, { passive: true })
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
      else scroll.scrollTo({ top: bottom(), behavior: 'smooth' })
    },
    dispose: () => {
      grow.disconnect()
      scroll.removeEventListener('scroll', onScroll)
      scroll.removeEventListener('wheel', onWheel)
      scroll.removeEventListener('pointerdown', steer)
      scroll.removeEventListener('touchstart', steer)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('keydown', onKey)
    },
  }
}
export type Follow = ReturnType<typeof follow>
