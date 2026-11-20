import { deadline } from '../../../lib/timers.ts'
import type { Cancel } from '../../../lib/timers.ts'

const nearBottomPx = 70
const keyScrollStartsWithinMs = 250

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
  let key: { event: KeyboardEvent; moved: boolean; expire: Cancel } | undefined
  const forgetKey = () => {
    key?.expire()
    key = undefined
  }
  const keyScrolls = () => !!key && !key.event.defaultPrevented && !consumedBy(key.event)
  const steering = () => pressed || touching || keyScrolls()
  const left = () => steering() && scroll.scrollTop < seen - 1 && distance() > 1
  const selecting = () => pressed && !!getSelection()?.toString()
  const onScroll = () => {
    if (key) key.moved = true
    const top = scroll.scrollTop
    if (left()) report({ following: false })
    else if (!following && top > seen && distance() <= 1) report({ following: true })
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
    if (event.deltaY < 0 && scroll.scrollHeight > scroll.clientHeight && !innerTakes(event.target))
      report({ following: false })
  }
  const upKey = (event: KeyboardEvent) =>
    ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)
  const keyControls =
    'textarea, select, input:not([type=button], [type=submit], [type=reset], [type=checkbox], [type=color], [type=file], [type=image])'
  const consumedBy = (event: KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (!target) return false
    if (target.isContentEditable || target.matches(keyControls)) return true
    return event.key === ' ' && target.matches('button, a[href], [role="button"], input')
  }
  const reader = {
    pointerdown: () => (pressed = true),
    pointerup: () => (pressed = false),
    pointercancel: () => (pressed = false),
    touchstart: () => (touching = true),
    touchend: () => (touching = false),
    touchcancel: () => (touching = false),
    keydown: (event: Event) => {
      const pressedKey = event as KeyboardEvent
      if (!upKey(pressedKey)) return
      forgetKey()
      key = { event: pressedKey, moved: false, expire: () => {} }
    },
    keyup: (event: Event) => {
      const held = key
      if (!held || (event as KeyboardEvent).key !== held.event.key) return
      held.expire = deadline(keyScrollStartsWithinMs, () => {
        if (key === held && !held.moved) key = undefined
      })
    },
  }
  const onTranscript = new Set(['pointerdown', 'touchstart'])
  const grow = new ResizeObserver(() => {
    if (following && !selecting()) place(bottom())
    report({})
  })
  scroll.addEventListener('scroll', onScroll, { passive: true })
  scroll.addEventListener('scrollend', forgetKey, { passive: true })
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
      forgetKey()
      grow.disconnect()
      scroll.removeEventListener('scroll', onScroll)
      scroll.removeEventListener('scrollend', forgetKey)
      scroll.removeEventListener('wheel', onWheel)
      for (const [type, listener] of Object.entries(reader))
        (onTranscript.has(type) ? scroll : window).removeEventListener(type, listener)
    },
  }
}
export type Follow = ReturnType<typeof follow>
