import { createRoot, createSignal, onSettled } from 'solid-js'
import { api, chordOf, formatKeys, ROOT, useAction } from '@/sdk/solid'
import { inProcess } from '../../lib/errors.shared.ts'
import { capture } from './capture.web.ts'
import type { Sink, Take } from './capture.web.ts'
import { SetSettingsAction, SettingsAction } from './refs.ts'
import type { DictationSettings } from './refs.ts'
import { createTalk } from './talk.web.ts'

const settings = createRoot(() => {
  const stored = useAction(SettingsAction, null, { conversation: ROOT, focus: true })
  const [pending, setPending] = createSignal<Partial<DictationSettings>>({})
  const read = <K extends keyof DictationSettings>(key: K, initial: DictationSettings[K]) =>
    pending()[key] ?? stored.data()?.[key] ?? initial
  const write = async (change: Partial<DictationSettings>) => {
    setPending((current) => ({ ...current, ...change }))
    try {
      await api.action(SetSettingsAction, change, { conversationId: ROOT })
      await stored.refetch()
    } finally {
      setPending(({ ...current }) => {
        for (const key of Object.keys(change) as (keyof DictationSettings)[])
          if (current[key] === change[key]) delete current[key]
        return current
      })
    }
  }
  return { read, write }
})

export const talkMode = () => settings.read('talk', 'tap')
export const setTalkMode = (talk: DictationSettings['talk']) => void settings.write({ talk })
export const shortcut = () => settings.read('shortcut', 'mod+shift+space')
export const setShortcut = (keys: string) => void settings.write({ shortcut: keys })
export const soundCues = () => settings.read('cues', true)
export const setSoundCues = (cues: boolean) => void settings.write({ cues })
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
