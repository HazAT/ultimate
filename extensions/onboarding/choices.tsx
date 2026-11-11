import { defaultOff } from '../../shared/extension-api.ts'

/**
 * The optional extensions the first run offers; each row's words are the first sentence of its README. `needs` is an
 * extension checked along with this one. Everything else that is on already folds into one read-only line.
 */
export const offered: readonly { name: string; needs?: string }[] = [
  { name: 'sounds' },
  { name: 'tailscale' },
  { name: 'parallel' },
  { name: 'health' },
  { name: 'cloud' },
  { name: 'classify' },
  { name: 'phase', needs: 'classify' },
]

/**
 * Where the Extensions panel's switches save: this project's settings once its setup is chosen, which is what the panel
 * and the action behind it act on, and the user's settings otherwise. A project's settings file is usually committed,
 * so picking `everywhere` is how a personal switch stays out of it.
 */
export function switchScope(local: boolean, chosen?: 'project' | 'user') {
  return local && chosen !== 'user' ? 'project' : 'user'
}

/**
 * The offered switches as the user's settings leave them: a default-off built-in is checked only when they enable it,
 * the rest unless they disable it.
 */
export function extensionOptions(
  user: { enable: readonly string[]; disable: readonly string[] },
  changed: Record<string, boolean>,
) {
  return offered.map((entry) => {
    const saved = defaultOff.includes(entry.name)
      ? user.enable.includes(entry.name)
      : !user.disable.includes(entry.name)
    return { ...entry, checked: changed[entry.name] ?? saved }
  })
}
