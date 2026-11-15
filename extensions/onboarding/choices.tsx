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
 * What a setup card shows as chosen: the answer given on it, else a choice that holds now however it was made, so a card
 * never offers a decision already taken elsewhere (the project's setup in the Extensions panel, or on another card).
 * Only the project card has such a standing decision; `decision` is the project's (null: undecided).
 */
export function settledChoice(
  card: string,
  answer: string | undefined,
  decision: boolean | null | undefined,
) {
  if (answer) return answer
  if (card === 'project' && typeof decision === 'boolean')
    return decision ? 'Using project setup' : 'Keeping global setup'
  return undefined
}

/**
 * Where the Extensions panel's switches save: the user's settings unless they pick this project, which needs the
 * project's setup chosen. A project's settings file is usually committed, so a personal switch never lands there.
 */
export function switchScope(local: boolean, chosen?: 'project' | 'user') {
  return local && chosen === 'project' ? 'project' : 'user'
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
