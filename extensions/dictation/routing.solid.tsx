import { createRoot, onSettled } from 'solid-js'
import { chordOf, useUiState } from '@/sdk/solid'
import { inProcess } from '../../lib/errors.ts'
import { capture } from './capture.ts'
import type { Sink } from './capture.ts'
import { createTalk } from './talk.ts'

export const [talkMode, setTalkMode] = createRoot(() =>
  useUiState<'hold' | 'tap'>('ext.dictation.talk', 'hold'),
)
export const [shortcut, setShortcut] = createRoot(() =>
  useUiState('ext.dictation.shortcut', 'mod+shift+space'),
)
export const keyChord = (event: KeyboardEvent) =>
  event.code === 'Space' ? chordOf(event).replace(/ $/, 'space') : chordOf(event)

type Target = { sink: Sink; wake?: () => void; signal?: AbortSignal; ready?: () => boolean }
type Box = Target & { root: Element }

const boxes = new Map<Element, Box>()
let fallback: Target | undefined

export function registerBox(box: Box) {
  boxes.set(box.root, box)
  return () => void boxes.delete(box.root)
}

export function setFallback(target: Target | undefined) {
  fallback = target
}

const boxSelector = '[data-ui="prompt-box"]'

function route() {
  const focused = document.activeElement?.closest(boxSelector)
  const box = focused && boxes.get(focused)
  if (box) return { target: box }
  if (fallback) return { target: fallback }
  const main = document.querySelector(
    `[data-ui="composer"][data-composer-target="conversation"] ${boxSelector}`,
  )
  const target = main && boxes.get(main)
  if (target) return { target, editor: main.querySelector('textarea') }
  return undefined
}

export function DictationShortcuts() {
  onSettled(() => {
    let owner: { sink: Sink; take: number } | undefined
    const talk = createTalk({
      tap: () => talkMode() === 'tap',
      talking() {
        if (!capture.talking()) return false
        if (owner && owner.take === capture.take(owner.sink)) return true
        const target = route()?.target
        if (!target) return false
        const sink = target.sink
        const take = capture.take(sink, target.signal)
        if (take === undefined) return false
        owner = { sink, take }
        return true
      },
      async press() {
        owner = undefined
        const routed = route()
        if (!routed || capture.talking()) return
        routed.editor?.focus()
        const { target } = routed
        if (target.ready && !target.ready()) return
        target.wake?.()
        const { sink, signal } = target
        const pressed = capture.press(sink, signal)
        const take = capture.take(sink, signal)
        if (take !== undefined) owner = { sink, take }
        await pressed
      },
      async release() {
        const finishing = owner
        owner = undefined
        if (finishing && finishing.take === capture.take(finishing.sink)) {
          await capture.release(finishing.sink)
        }
      },
      cancel: () => capture.cancel(),
      overCancel: () => false,
      matches: (event) => keyChord(event) === shortcut().trim().toLowerCase(),
    })
    const listeners = new AbortController()
    const options = { capture: true, signal: listeners.signal }
    let escapeCancelled = false
    const swallow = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') {
          if (!event.repeat) {
            escapeCancelled = capture.talking()
            if (escapeCancelled) {
              owner = undefined
              talk.reset()
              inProcess('a recording lives and ends with this open page', capture.cancel())
            }
          }
          if (!escapeCancelled) return
          event.preventDefault()
          event.stopImmediatePropagation()
        } else if (
          !(
            event.target instanceof Element &&
            event.target.closest('[data-dictation-shortcut-recorder]')
          ) &&
          talk.keyDown(event)
        ) {
          swallow(event)
        }
      },
      options,
    )
    window.addEventListener(
      'keyup',
      (event) => {
        if (event.key === 'Escape') escapeCancelled = false
        else if (talk.keyUp(event)) swallow(event)
      },
      options,
    )
    return () => {
      listeners.abort()
      talk.reset()
    }
  })
  return null
}
