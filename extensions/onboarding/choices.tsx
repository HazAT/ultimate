import { defaultOff } from '../../shared/extension-api.ts'

/**
 * The first-run switches. `needs` is an extension checked along with this one; `hint` says what a default-off one
 * needs from the user.
 */
export const recommended: readonly { name: string; line: string; needs?: string; hint?: string }[] =
  [
    { name: 'subagents', line: 'Hands bounded work to helper agents' },
    { name: 'messages', line: 'Talk to @ultimate and the project team' },
    { name: 'lineage', line: 'Roots, branches and the project context' },
    { name: 'onboarding', line: 'Setup cards and extension choices' },
    { name: 'plan', line: 'Durable epics and tasks for long work' },
    { name: 'automations', line: 'Prompts that run on a schedule', needs: 'subagents' },
    { name: 'documents', line: 'Extension state in the right panel' },
    { name: 'tasks', line: 'What runs right now, live' },
    { name: 'info', line: 'Machine, code, and extensions at a glance' },
    { name: 'update', line: 'Tells you when Ultimate has updates' },
    {
      name: 'parallel',
      line: 'Web search and fetch (parallel.ai)',
      hint: 'needs a Parallel API key',
    },
    {
      name: 'exa',
      line: 'Web search and fetch (exa.ai), instead of parallel',
      hint: 'needs an Exa API key',
    },
    { name: 'cloud', line: 'Encrypted project backups', hint: 'needs your own backup Worker' },
    { name: 'tailscale', line: 'Reach Ultimate from your devices', hint: 'needs Tailscale here' },
    { name: 'health', line: 'Provider health', hint: 'shows failing providers' },
    { name: 'classify', line: 'Typed judgments from Jev', hint: 'needs a Jev key' },
    { name: 'phase', line: 'Working-phase labels', needs: 'classify', hint: 'needs a Jev key' },
    { name: 'sounds', line: 'Notification sounds', hint: 'plays when @ultimate needs you' },
  ]

/**
 * Where the Extensions panel's switches save: the user's settings unless they pick this project, which needs the
 * project's setup chosen. A project's settings file is usually committed, so a personal switch never lands there.
 */
export function switchScope(local: boolean, chosen?: 'project' | 'user') {
  return local && chosen === 'project' ? 'project' : 'user'
}

/**
 * The switches as the user's settings leave them: a default-off built-in is checked only when they enable it, the rest
 * unless they disable it. The `core` tier extensions are always on, so their boxes stay checked and locked.
 */
export function extensionOptions(
  user: { enable: readonly string[]; disable: readonly string[] },
  changed: Record<string, boolean>,
  core: readonly string[],
) {
  return recommended.map((entry) => {
    const required = core.includes(entry.name)
    const saved = defaultOff.includes(entry.name)
      ? user.enable.includes(entry.name)
      : !user.disable.includes(entry.name)
    return {
      ...entry,
      required,
      checked: required || (changed[entry.name] ?? saved),
      hint: required
        ? 'core, always on'
        : (entry.hint ?? (entry.needs ? `needs ${entry.needs}` : undefined)),
    }
  })
}
