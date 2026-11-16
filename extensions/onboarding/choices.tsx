import { defaultOff } from '../../shared/extension-api.ts'

export const offered: readonly { name: string; needs?: string }[] = [
  { name: 'sounds' },
  { name: 'tailscale' },
  { name: 'parallel' },
  { name: 'health' },
  { name: 'cloud' },
  { name: 'classify' },
  { name: 'phase', needs: 'classify' },
]

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

export function switchScope(projectSetupChosen: boolean, chosen?: 'project' | 'user') {
  const useProjectSettings = projectSetupChosen && chosen === 'project'
  return useProjectSettings ? 'project' : 'user'
}

export function extensionOptions(
  user: { enable: readonly string[]; disable: readonly string[] },
  changed: Record<string, boolean>,
) {
  return offered.map((entry) => {
    const userEnabled = defaultOff.includes(entry.name)
      ? user.enable.includes(entry.name)
      : !user.disable.includes(entry.name)
    return { ...entry, checked: changed[entry.name] ?? userEnabled }
  })
}
