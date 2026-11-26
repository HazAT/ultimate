import { deadline } from '../../../lib/timers.ts'
import type { Cancel } from '../../../lib/timers.ts'

const holdMs = 450
const slopPx = 10

export function bindLongPress(el: HTMLElement, enabled: () => boolean, held: () => void): Cancel {
  let cancel: Cancel | undefined
  let start: { x: number; y: number; id: number } | undefined
  let fired = false
  const stop = () => {
    cancel?.()
    cancel = undefined
    start = undefined
  }
  const down = (event: PointerEvent) => {
    stop()
    fired = false
    if (!enabled() || event.button !== 0 || !event.isPrimary) return
    start = { x: event.clientX, y: event.clientY, id: event.pointerId }
    cancel = deadline(holdMs, () => {
      stop()
      if (!enabled()) return
      fired = true
      held()
    })
  }
  const move = (event: PointerEvent) => {
    if (start?.id !== event.pointerId) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > slopPx) stop()
  }
  const click = (event: MouseEvent) => {
    if (!fired) return
    fired = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const menu = (event: MouseEvent) => {
    if (!enabled()) return
    event.preventDefault()
    if (fired) return
    stop()
    fired = event.button !== 2
    held()
  }
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', stop)
  el.addEventListener('pointercancel', stop)
  el.addEventListener('pointerleave', stop)
  el.addEventListener('click', click, true)
  el.addEventListener('contextmenu', menu)
  return () => {
    stop()
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', stop)
    el.removeEventListener('pointercancel', stop)
    el.removeEventListener('pointerleave', stop)
    el.removeEventListener('click', click, true)
    el.removeEventListener('contextmenu', menu)
  }
}
