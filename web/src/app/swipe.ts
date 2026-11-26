import { createSignal, onCleanup } from 'solid-js'
import { touchKeyboard } from '../sdk/viewport.ts'

export type Side = 'left' | 'right'

export type SwipeTarget = {
  side: () => Side
  open: () => boolean
  width: () => number
  onOpen: () => void
  onClose: () => void
}

const LOCK_DISTANCE = 10
const LOCK_RATIO = 1.5
const FLING_SPEED = 0.4
const SKIPPED =
  'textarea, input, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [popover]'

const [swipe, setSwipe] = createSignal<{ side: Side; progress: number }>()

export const swipeProgress = (side: Side) => {
  const current = swipe()
  return current?.side === side ? current.progress : undefined
}

const targets = new Set<SwipeTarget>()
let detach: (() => void) | undefined

export function registerSwipeTarget(target: SwipeTarget) {
  targets.add(target)
  detach ??= listen()
  onCleanup(() => {
    targets.delete(target)
    if (targets.size === 0) {
      detach?.()
      detach = undefined
    }
  })
}

function canScrollSideways(from: EventTarget | null, toward: 1 | -1) {
  for (let node = from as Element | null; node instanceof HTMLElement; node = node.parentElement) {
    const { overflowX } = getComputedStyle(node)
    if (overflowX !== 'auto' && overflowX !== 'scroll') continue
    if (node.scrollWidth <= node.clientWidth + 1) continue
    const room =
      toward > 0 ? node.scrollLeft : node.scrollWidth - node.clientWidth - node.scrollLeft
    if (room > 1) return true
  }
  return false
}

function pick(toward: 1 | -1) {
  const all = [...targets]
  const open = all.find((target) => target.open())
  if (open) return (open.side() === 'left') === toward < 0 ? open : undefined
  return all.find((target) => target.side() === (toward > 0 ? 'left' : 'right'))
}

function listen() {
  type Touch = {
    x: number
    y: number
    origin: EventTarget | null
    locked?: { target: SwipeTarget; wasOpen: boolean; width: number }
    last: { x: number; at: number }
    speed: number
  }
  let touch: Touch | undefined

  const progress = (current: Touch, x: number) => {
    const { target, wasOpen, width } = current.locked!
    const opening = target.side() === 'left' ? 1 : -1
    const dragged = ((x - current.x) * opening) / width
    return Math.min(1, Math.max(0, wasOpen ? 1 + dragged : dragged))
  }

  const start = (event: TouchEvent) => {
    touch = undefined
    if (event.touches.length !== 1 || !touchKeyboard()) return
    const origin = event.target
    if (origin instanceof Element && origin.closest(SKIPPED)) return
    if (getSelection()?.toString()) return
    const { clientX: x, clientY: y } = event.touches[0]
    touch = { x, y, origin, last: { x, at: event.timeStamp }, speed: 0 }
  }

  const move = (event: TouchEvent) => {
    const current = touch
    if (!current) return
    const { clientX: x, clientY: y } = event.touches[0]
    if (!current.locked) {
      const dx = x - current.x
      const dy = y - current.y
      if (Math.abs(dy) > LOCK_DISTANCE && Math.abs(dy) * LOCK_RATIO >= Math.abs(dx)) {
        touch = undefined
        return
      }
      if (Math.abs(dx) <= LOCK_DISTANCE || Math.abs(dx) <= Math.abs(dy) * LOCK_RATIO) return
      const toward = dx > 0 ? 1 : -1
      const target = canScrollSideways(current.origin, toward) ? undefined : pick(toward)
      if (!target) {
        touch = undefined
        return
      }
      current.locked = {
        target,
        wasOpen: target.open(),
        width: target.width(),
      }
    }
    const elapsed = event.timeStamp - current.last.at
    if (elapsed > 0) current.speed = (x - current.last.x) / elapsed
    current.last = { x, at: event.timeStamp }
    if (event.cancelable) event.preventDefault()
    setSwipe({
      side: current.locked.target.side(),
      progress: progress(current, x),
    })
  }

  const end = (event: TouchEvent) => {
    const current = touch
    touch = undefined
    if (!current?.locked) return
    const { target, wasOpen } = current.locked
    const x = event.changedTouches[0]?.clientX ?? current.last.x
    const opening = target.side() === 'left' ? 1 : -1
    const flung = Math.abs(current.speed) > FLING_SPEED
    const wantsOpen =
      event.type === 'touchcancel'
        ? wasOpen
        : flung
          ? current.speed * opening > 0
          : progress(current, x) > 0.5
    if (wantsOpen !== wasOpen) (wantsOpen ? target.onOpen : target.onClose)()
    setSwipe(undefined)
  }

  document.addEventListener('touchstart', start, { passive: true })
  document.addEventListener('touchmove', move, { passive: false })
  document.addEventListener('touchend', end)
  document.addEventListener('touchcancel', end)
  return () => {
    document.removeEventListener('touchstart', start)
    document.removeEventListener('touchmove', move)
    document.removeEventListener('touchend', end)
    document.removeEventListener('touchcancel', end)
  }
}
