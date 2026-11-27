export const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * The shortcut a key press spells, as the shortcut registry matches it: the letter it types (on any layout), else its
 * physical key for a letter or digit typed with Alt or Shift, else its key name: `mod+shift+space`, `mod+k`.
 */
export function chordOf(event: KeyboardEvent): string {
  const typed = event.key.length === 1 ? event.key.toLowerCase() : ''
  const key =
    typed === ' '
      ? 'space'
      : /^[a-z0-9]$/.test(typed)
        ? typed
        : event.code.startsWith('Key')
          ? event.code.slice(3).toLowerCase()
          : event.code.startsWith('Digit')
            ? event.code.slice(5)
            : event.key.toLowerCase()
  const parts = []
  if (isMac ? event.metaKey : event.ctrlKey) parts.push('mod')
  if (isMac && event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  if (!['meta', 'control', 'alt', 'shift'].includes(key)) parts.push(key)
  return parts.join('+')
}

const order = ['mod', 'ctrl', 'alt', 'shift']

const symbols: Record<string, string> = isMac
  ? {
      mod: '⌘',
      ctrl: '⌃',
      alt: '⌥',
      shift: '⇧',
      enter: '↵',
      escape: 'esc',
      tab: '⇥',
      space: 'Space',
    }
  : {
      mod: 'Ctrl',
      ctrl: 'Ctrl',
      alt: 'Alt',
      shift: 'Shift',
      enter: '↵',
      escape: 'Esc',
      tab: 'Tab',
      space: 'Space',
    }

/** Display keys of a shortcut, modifiers first: `shift+mod+k` → ['⌘', '⇧', 'K']. */
export function formatKeys(keys: string): string[] {
  const parts = keys
    .trim()
    .toLowerCase()
    .split('+')
    .map((part) => (part === 'esc' ? 'escape' : part))
  return [
    ...order.filter((modifier) => parts.includes(modifier)),
    ...parts.filter((part) => !order.includes(part)),
  ].map((part) => symbols[part] ?? (part.length === 1 ? part.toUpperCase() : part))
}
