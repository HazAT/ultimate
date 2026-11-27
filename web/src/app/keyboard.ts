import { allCommands, applies, currentContext, runCommand } from '../sdk/actions.ts'
import { registry } from '../sdk/client.ts'
import type { CommandItem } from '../sdk/registry.ts'
import { scopeOf } from '../sdk/scope.ts'
import { registerShortcut } from '../sdk/shortcuts.ts'

const inComposer = (focused: Element | null) =>
  focused instanceof HTMLTextAreaElement && !!focused.closest('[data-composer-target]')
const inDraftComposer = (focused: Element | null) =>
  !!focused?.closest('[data-composer-target="draft"]')
const inPopup = (focused: Element | null) =>
  !!focused?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')
const typing = (focused: Element | null) =>
  focused instanceof HTMLElement &&
  (focused.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName))
const plainKey = (keys: string) => !/\b(mod|alt|ctrl)\+/.test(keys)

function allowedAt(command: CommandItem, keys: string, focused: Element | null) {
  if (!plainKey(keys)) return true
  if (inDraftComposer(focused) || inPopup(focused)) return false
  if (inComposer(focused)) return !!command.whileTyping
  return !typing(focused)
}

function register(id: string, keys: string, title: string, latest: () => CommandItem | undefined) {
  const context = () => currentContext(scopeOf(document.activeElement))
  return registerShortcut(keys, () => runCommand(id, context()), {
    allowInInput: true,
    description: title,
    when: () => {
      const command = latest()
      return (
        !!command && allowedAt(command, keys, document.activeElement) && applies(command, context())
      )
    },
  })
}

export function installShortcuts() {
  let current = new Map<string, CommandItem>()
  const registered = new Map<string, { shape: string; release: () => void }>()
  const sync = () => {
    current = new Map(
      allCommands().flatMap((command) => (command.keys ? [[command.id, command]] : [])),
    )
    const shapeOf = (command: CommandItem) => `${command.keys}\n${command.title}`
    for (const [id, { shape, release }] of registered) {
      const command = current.get(id)
      if (command && shapeOf(command) === shape) continue
      release()
      registered.delete(id)
    }
    for (const [id, command] of current)
      if (!registered.has(id))
        registered.set(id, {
          shape: shapeOf(command),
          release: register(id, command.keys!, command.title, () => current.get(id)),
        })
  }
  sync()
  const unsubscribe = registry.subscribe(sync)
  return () => {
    unsubscribe()
    for (const { release } of registered.values()) release()
  }
}
