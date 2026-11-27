import { bindLayer } from '@ui-sdk/core'
import { shortcuts } from '@ui-sdk/solid/shortcuts'
import type { ShortcutHandler, ShortcutKeys, ShortcutOptions } from '@ui-sdk/solid/shortcuts'
import { createEffect } from 'solid-js'
import type { Accessor } from 'solid-js'
import { cell } from '../../../lib/cell.web.ts'

type Listed = { keys: ShortcutKeys; options: ShortcutOptions }

const listed = cell<readonly Listed[]>([])

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

/** Every registered shortcut with a description, oldest first, whether or not it would run now: `{ keys, description }`. */
export function listShortcuts(): { keys: string; description: string }[] {
  return listed.get().flatMap(({ keys, options }) => {
    const current = typeof keys === 'function' ? keys() : keys
    return current && options.description
      ? [{ keys: current, description: options.description }]
      : []
  })
}

/** Runs `listener` whenever a shortcut registers or leaves; returns its unsubscribe. */
export const onShortcutsChanged = listed.subscribe

/**
 * Claims Escape until the returned release runs, ahead of every shortcut and of every popup opened before it, as a
 * popover does: for something pending that Escape cancels, such as a recording or an answer's undo window. A held
 * Escape cancels once: its repeats only keep the claim.
 */
export function holdEscape(cancel: () => void): () => void {
  return bindLayer(document.createElement('div'), {
    onDismiss: (reason, event) => {
      if (reason === 'escape-key' && !(event as KeyboardEvent).repeat) cancel()
    },
  })
}
