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
  let touching = false
  const steering = () => pressed || touching
  const left = () => steering() && scroll.scrollTop < seen - 1 && distance() > 1
  const selecting = () => pressed && !!getSelection()?.toString()
  const onScroll = () => {
    const top = scroll.scrollTop
    if (left()) report({ following: false })
    else if (!following && top > seen + 1 && distance() <= 1) report({ following: true })
    else report({})
    seen = top
  }
  const movesUp = (element: Element) =>
    element.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(element).overflowY)
  const innerTakes = (target: EventTarget | null) => {
    for (
      let element = target instanceof Element ? target : null;
      element && element !== scroll;
      element = element.parentElement
    )
      if (movesUp(element)) return true
    return false
  }
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0 && !innerTakes(event.target)) report({ following: false })
  }
  const typing = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || !!target.closest('input, textarea'))
  const upKeys = new Set(['ArrowUp', 'PageUp', 'Home'])
  const reader = {
    pointerdown: () => (pressed = true),
    pointerup: () => (pressed = false),
    pointercancel: () => (pressed = false),
    touchstart: () => (touching = true),
    touchend: () => (touching = false),
    touchcancel: () => (touching = false),
    keydown: (event: Event) => {
      const key = event as KeyboardEvent
      if (upKeys.has(key.key) && !typing(key.target)) report({ following: false })
    },
  }
  const onTranscript = new Set(['pointerdown', 'touchstart'])
  const grow = new ResizeObserver(() => {
    if (following && !selecting()) place(bottom())
    report({})
  })
  scroll.addEventListener('scroll', onScroll, { passive: true })
  scroll.addEventListener('wheel', onWheel, { passive: true })
  for (const [type, listener] of Object.entries(reader))
    (onTranscript.has(type) ? scroll : window).addEventListener(type, listener, { passive: true })
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
      for (const [type, listener] of Object.entries(reader))
        (onTranscript.has(type) ? scroll : window).removeEventListener(type, listener)
    },
  }
}
export type Follow = ReturnType<typeof follow>
