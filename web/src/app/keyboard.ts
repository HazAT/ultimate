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

export function installShortcuts() {
  let byId = new Map<string, CommandItem>()
  const registered = new Map<string, () => void>()
  const register = (id: string) => {
    const context = () => currentContext(scopeOf(document.activeElement))
    return registerShortcut(
      () => byId.get(id)?.keys,
      () => runCommand(id, context()),
      {
        allowInInput: true,
        description: byId.get(id)?.title,
        when: () => {
          const command = byId.get(id)
          return (
            !!command?.keys &&
            allowedAt(command, command.keys, document.activeElement) &&
            applies(command, context())
          )
        },
      },
    )
  }
  const sync = () => {
    byId = new Map(
      allCommands().flatMap((command) => (command.keys ? [[command.id, command]] : [])),
    )
    for (const [id, release] of registered)
      if (!byId.has(id)) {
        release()
        registered.delete(id)
      }
    for (const id of byId.keys()) if (!registered.has(id)) registered.set(id, register(id))
  }
  sync()
  const unsubscribe = registry.subscribe(sync)
  return () => {
    unsubscribe()
    for (const release of registered.values()) release()
  }
}
