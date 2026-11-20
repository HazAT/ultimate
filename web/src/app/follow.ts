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
  let keying = false
  let wheeled = false
  const steering = () => pressed || touching || keying || wheeled
  const left = () => steering() && scroll.scrollTop < seen - 1 && distance() > 1
  const selecting = () => pressed && !!getSelection()?.toString()
  const onScroll = () => {
    const top = scroll.scrollTop
    if (left()) report({ following: false })
    else if (steering() && !following && top > seen + 1 && distance() <= 1)
      report({ following: true })
    else report({})
    seen = top
    wheeled = false
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
    wheeled = true
    if (event.deltaY < 0) report({ following: false })
  }
  const inputs = {
    pointerdown: () => (pressed = true),
    touchstart: () => (touching = true),
    touchend: () => (touching = false),
    touchcancel: () => (touching = false),
    keydown: () => (keying = true),
    keyup: () => (keying = false),
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
  for (const [type, listener] of Object.entries(inputs))
    scroll.addEventListener(type, listener, { passive: true })
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
      else scroll.scrollTo({ top: bottom(), behavior: 'smooth' })
    },
    dispose: () => {
      grow.disconnect()
      scroll.removeEventListener('scroll', onScroll)
      scroll.removeEventListener('wheel', onWheel)
      for (const [type, listener] of Object.entries(inputs))
        scroll.removeEventListener(type, listener)
      window.removeEventListener('pointerup', release)
    },
  }
}
export type Follow = ReturnType<typeof follow>
