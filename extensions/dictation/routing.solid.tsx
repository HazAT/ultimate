import { createRoot, onSettled } from 'solid-js'
import { chordOf, formatKeys, useUiState } from '@/sdk/solid'
import { inProcess } from '../../lib/errors.ts'
import { capture } from './capture.ts'
import type { Sink, Take } from './capture.ts'
import { createTalk } from './talk.ts'

export const [talkMode, setTalkMode] = createRoot(() =>
  useUiState<'hold' | 'tap'>('ext.dictation.talk', 'tap'),
)
export const [shortcut, setShortcut] = createRoot(() =>
  useUiState('ext.dictation.shortcut', 'mod+shift+space'),
)
export const [soundCues, setSoundCues] = createRoot(() => useUiState('ext.dictation.cues', true))
export const shortcutHint = () => ({
  gesture: talkMode(),
  keys: formatKeys(shortcut())[0].join('+'),
})
export const keyChord = (event: KeyboardEvent) =>
  event.code === 'Space' ? chordOf(event).replace(/ $/, 'space') : chordOf(event)

type Target = { sink: Sink; wake?: () => void; ready?: () => boolean }
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
    let owner: Take | undefined
    const matches = (event: KeyboardEvent) => keyChord(event) === shortcut().trim().toLowerCase()
    const talk = createTalk({
      tap: () => talkMode() === 'tap',
      talking: () => owner?.active() ?? false,
      async press() {
        owner = undefined
        const routed = route()
        if (!routed || capture.talking()) return
        routed.editor?.focus()
        const { target } = routed
        if (target.ready && !target.ready()) return
        target.wake?.()
        owner = capture.press(target.sink)
        await owner?.started
      },
      async release() {
        const finishing = owner
        owner = undefined
        await finishing?.release()
      },
      cancel: async () => owner?.cancel(),
      overCancel: () => false,
      matches,
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
        if (
          event.key === 'Escape' ||
          (event.target instanceof Element &&
            event.target.closest('[data-dictation-shortcut-recorder]'))
        )
          return
        if (talkMode() === 'tap' && !event.repeat && !owner?.active() && matches(event)) {
          const target = route()?.target
          owner = target && capture.take(target.sink)
        }
        if (talk.keyDown(event)) swallow(event)
      },
      options,
    )
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        const take = capture.take()
        if (!event.repeat) {
          escapeCancelled = !!take
          if (take) {
            owner = undefined
            talk.reset()
            inProcess('a recording lives and ends with this open page', take.cancel())
          }
        }
        if (!take && !escapeCancelled) return
        event.preventDefault()
        event.stopImmediatePropagation()
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
