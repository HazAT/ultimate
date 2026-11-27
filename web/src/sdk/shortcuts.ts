import { ariaKeyshortcuts, bindLayer } from '@ui-sdk/core'
import { shortcuts } from '@ui-sdk/solid/shortcuts'
import type { ShortcutHandler, ShortcutKeys, ShortcutOptions } from '@ui-sdk/solid/shortcuts'
import { createEffect } from 'solid-js'
import type { Accessor } from 'solid-js'
import { cell } from '../../../lib/cell.web.ts'

type Listed = { keys: ShortcutKeys; options: ShortcutOptions }

const listed = cell<readonly Listed[]>([])
const holds = cell(0)

/**
 * Registers a keyboard shortcut in the page's one registry, ui-sdk's, until the returned cleanup runs. A field that
 * handles a key itself calls `preventDefault`, and no shortcut sees it; a modal dialog pauses page shortcuts; between
 * two that match, the one in the topmost layer wins, then the newest. A `description` lists it in the Shortcuts panel.
 */
export function registerShortcut(
  keys: ShortcutKeys,
  run: ShortcutHandler,
  options: ShortcutOptions = {},
): () => void {
  const entry = { keys, options }
  listed.set([...listed.get(), entry])
  const release = shortcuts.register(keys, run, options)
  return () => {
    release()
    listed.set(listed.get().filter((other) => other !== entry))
  }
}

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
 * Every described shortcut, oldest first: those registered here whether or not they would run now, and those ui-sdk's
 * own parts registered that would run now, such as a toast region's F6.
 */
export function listShortcuts(): { keys: string; description: string }[] {
  const ours = listed.get().flatMap(({ keys, options }) => {
    const current = typeof keys === 'function' ? keys() : keys
    return current && options.description
      ? [{ keys: current, description: options.description }]
      : []
  })
  const theirs = shortcuts
    .list()
    .flatMap(({ keys, description }) =>
      description &&
      !ours.some((row) => row.description === description && sameKeys(row.keys, keys))
        ? [{ keys, description }]
        : [],
    )
  return [...ours, ...theirs]
}

/** Runs `listener` whenever a shortcut registers or leaves; returns its unsubscribe. */
export const onShortcutsChanged = listed.subscribe

export const escapeHeld = () => holds.get() > 0

/**
 * Claims Escape until the returned release runs, ahead of every shortcut and of every popup opened before it, as a
 * popover does: for something pending that Escape cancels, such as a recording. One press cancels once: its repeats,
 * even after the release, reach nothing beneath until the key comes up.
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
      cancel()
    },
  })
  const end = () => {
    window.removeEventListener('keyup', up)
    unbind()
  }
  function up(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    pressed = false
    if (!held) end()
  }
  return () => {
    if (!held) return
    held = false
    holds.set(holds.get() - 1)
    if (!pressed) end()
  }
}
