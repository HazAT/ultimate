import { ariaKeyshortcuts, bindLayer } from '@ui-sdk/core'
import { shortcuts } from '@ui-sdk/solid/shortcuts'
import type { ShortcutHandler, ShortcutKeys, ShortcutOptions } from '@ui-sdk/solid/shortcuts'
import { createEffect } from 'solid-js'
import type { Accessor } from 'solid-js'
import { cell } from '../../../lib/cell.web.ts'

type Listed = { keys: ShortcutKeys; options: ShortcutOptions }

const listed = cell<readonly Listed[]>([])
const holds = cell(0)
const register = shortcuts.register.bind(shortcuts)

shortcuts.register = (keys, run, options = {}) => {
  const entry = { keys, options }
  listed.set([...listed.get(), entry])
  const release = register(keys, run, options)
  return () => {
    release()
    listed.set(listed.get().filter((other) => other !== entry))
  }
}

/**
 * Registers a keyboard shortcut in the page's one registry, ui-sdk's, until the returned cleanup runs. A field that
 * handles a key itself calls `preventDefault`, and no shortcut sees it; a modal dialog pauses page shortcuts; between
 * two that match, the one in the topmost layer wins, then the newest. A `description` names it in the Shortcuts panel.
 */
export const registerShortcut = (
  keys: ShortcutKeys,
  run: ShortcutHandler,
  options: ShortcutOptions = {},
): (() => void) => shortcuts.register(keys, run, options)

/** `registerShortcut` for the life of a component; keys and options may be accessors, and `undefined` keys register nothing. */
export function useShortcut(
  keys: ShortcutKeys | undefined,
  run: ShortcutHandler,
  options: ShortcutOptions | Accessor<ShortcutOptions> = {},
): void {
  createEffect(
    () => (typeof options === 'function' ? options() : options),
    (current) => (keys ? registerShortcut(keys, run, current) : undefined),
  )
}

/** Whether two shortcuts name the same keys, whatever their order or spelling: `shift+mod+k` and `Mod+Shift+K`. */
export const sameKeys = (a: string, b: string) => {
  const parts = (keys: string) => ariaKeyshortcuts(keys).split('+').toSorted().join('+')
  return parts(a) === parts(b)
}

/**
 * Every shortcut registered on the page, oldest first, whether or not it would run now, ui-sdk's own parts' included
 * (a toast region's F6): its keys and, when it has one, its description.
 */
export function listShortcuts(): { keys: string; description?: string }[] {
  return listed.get().flatMap(({ keys, options }) => {
    const current = typeof keys === 'function' ? keys() : keys
    return current ? [{ keys: current, description: options.description }] : []
  })
}

/** Runs `listener` whenever a shortcut registers or leaves; returns its unsubscribe. */
export const onShortcutsChanged = listed.subscribe

export const escapeHeld = () => holds.get() > 0

/**
 * Claims Escape until the returned release runs, ahead of every shortcut and of every popup opened before it, as a
 * popover does: for something pending that Escape cancels, such as a recording. One press cancels once: its repeats,
 * even after the release, reach nothing beneath, a focused field included, until the key comes up or the window
 * loses focus.
 */
export function holdEscape(cancel: () => void): () => void {
  let pressed = false
  let held = true
  holds.set(holds.get() + 1)
  const unbind = bindLayer(document.createElement('div'), {
    onDismiss: (reason, event) => {
      if (reason !== 'escape-key' || (event as KeyboardEvent).repeat) return
      pressed = true
      window.addEventListener('keyup', up)
      window.addEventListener('blur', letGo)
      cancel()
    },
  })
  const end = () => {
    window.removeEventListener('keyup', up)
    window.removeEventListener('blur', letGo)
    holds.set(holds.get() - 1)
    unbind()
  }
  function letGo() {
    pressed = false
    if (!held) end()
  }
  function up(event: KeyboardEvent) {
    if (event.key === 'Escape') letGo()
  }
  return () => {
    if (!held) return
    held = false
    if (!pressed) end()
  }
}
