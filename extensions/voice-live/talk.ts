import { inProcess } from '../../lib/errors.ts'
import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'

const AUTO_REPEAT_GAP_MS = 120
const MODIFIERS = ['Meta', 'Control', 'Shift', 'Alt']
const onThisPage = (work: Promise<void>) =>
  inProcess('a recording lives and ends with this open page', work)

export function createTalk(talk: {
  tap: () => boolean
  talking: () => boolean
  press: () => Promise<void>
  release: () => Promise<void>
  cancel: () => Promise<void>
  overCancel: (event: PointerEvent) => boolean
  matches: (event: KeyboardEvent) => boolean
  wake: () => void
}) {
  const start = () => onThisPage(talk.tap() && talk.talking() ? talk.release() : talk.press())
  const stop = () => {
    if (!talk.tap()) onThisPage(talk.release())
  }
  let pointer = false
  let held: string | undefined
  let letGo: Cancel | undefined
  let gesture = 0
  const cancel = () => {
    if (!talk.talking()) return false
    gesture++
    pointer = false
    held = undefined
    letGo?.()
    letGo = undefined
    onThisPage(talk.cancel())
    return true
  }
  const letGoPointer = (event: PointerEvent) => {
    if (!pointer) return
    if (talk.overCancel(event) && cancel()) return
    pointer = false
    stop()
  }
  return {
    cancel,
    pointer: {
      onPointerDown: (event: PointerEvent) => {
        event.preventDefault()
        pointer = true
        start()
      },
      onPointerCancel: letGoPointer,
      onPointerLeave: letGoPointer,
      onPointerUp: letGoPointer,
    },
    keyDown(event: KeyboardEvent) {
      if (talk.tap()) {
        if (!talk.matches(event)) return false
        if (event.repeat) return true
        talk.wake()
        start()
        return true
      }
      if (held !== undefined) {
        if (event.code !== held && !event.repeat) return false
        letGo?.()
        letGo = undefined
        return true
      }
      if (event.repeat || !talk.matches(event)) return false
      held = event.code
      const mine = ++gesture
      talk.wake()
      onThisPage(
        talk.press().then(() => {
          if (held === undefined && gesture === mine) return talk.release()
          return undefined
        }),
      )
      return true
    },
    keyUp(event: KeyboardEvent) {
      if (held === undefined) return false
      if (event.code !== held && !MODIFIERS.includes(event.key)) return false
      letGo?.()
      letGo = deadline(AUTO_REPEAT_GAP_MS, () => {
        letGo = undefined
        held = undefined
        onThisPage(talk.release())
      })
      return true
    },
  }
}
