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
  matches: (event: KeyboardEvent) => boolean
  wake: () => void
}) {
  const start = () => onThisPage(talk.tap() && talk.talking() ? talk.release() : talk.press())
  const stop = () => {
    if (!talk.tap()) onThisPage(talk.release())
  }
  let pointer = false
  const letGoPointer = () => {
    if (!pointer) return
    pointer = false
    stop()
  }
  let held: string | undefined
  let letGo: Cancel | undefined
  return {
    pointer: {
      onPointerDown: (event: PointerEvent) => {
        event.preventDefault()
        pointer = true
        start()
      },
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
      talk.wake()
      onThisPage(
        talk.press().then(() => {
          if (held === undefined) return talk.release()
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
