import { debounce } from '../../../lib/timers.ts'
import { allCommands, applies, currentContext, runCommand } from '../sdk/actions.ts'
import { store } from '../sdk/client.ts'
import { scopeOf } from '../sdk/conversation-scope.tsx'
import { chordOf, parseKeys } from '../sdk/keys.ts'
import type { CommandItem } from '../sdk/registry.ts'

function editable(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

export function installShortcuts() {
  let pending: string[] = []
  const resetPending = debounce(1200, () => (pending = []))
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return
    const chord = chordOf(event)
    if (!chord || ['mod', 'alt', 'shift', 'ctrl'].includes(chord)) return
    const sequence = [...pending, chord]
    const context = currentContext(scopeOf(event.target))
    const candidates = allCommands().flatMap((command) =>
      command.keys && applies(command, context) ? [{ command, keys: parseKeys(command.keys) }] : [],
    )
    const typing = editable(event.target)
    const composer =
      event.target instanceof HTMLTextAreaElement &&
      !!event.target.closest('[data-composer-target]')
    const emptyPalette =
      store.getState().ui.paletteOpen &&
      event.target instanceof HTMLInputElement &&
      event.target.value === ''
    const dialogOpen = !!document.querySelector('[role="dialog"]')
    const allowed = ({ command, keys }: { command: CommandItem; keys: string[] }) => {
      const continuingCapturedSequence = sequence.length > 1
      if (continuingCapturedSequence) return !typing || emptyPalette
      if (/\b(mod|alt|ctrl)\+/.test(keys[0] ?? '')) return true
      if (command.whileTyping) return !dialogOpen && (!typing || composer)
      return !typing
    }
    const exact = candidates.find(
      ({ keys }) => keys.length === sequence.length && keys.every((key, i) => key === sequence[i]),
    )
    const longer = candidates.some(
      ({ keys }) => keys.length > sequence.length && sequence.every((key, i) => keys[i] === key),
    )
    resetPending.cancel()
    pending = []
    if (exact && allowed(exact)) {
      event.preventDefault()
      if (sequence.length > 1) store.setUi({ paletteOpen: false })
      runCommand(exact.command.id, context)
    }
    if (longer && (exact || !typing || /\b(mod|alt|ctrl)\+/.test(chord))) {
      if (!exact) event.preventDefault()
      pending = sequence
      resetPending()
    }
  }
  window.addEventListener('keydown', onKeyDown, { capture: true })
  return () => {
    resetPending.cancel()
    window.removeEventListener('keydown', onKeyDown, { capture: true })
  }
}
