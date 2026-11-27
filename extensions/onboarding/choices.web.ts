import { defaultOff } from '../../shared/extension-api.ts'

export type Offer = {
  key: string
  names: readonly string[]
  title?: string
  text?: string
  aside?: string
  recommended?: boolean
}

export const offered: readonly Offer[] = [
  {
    key: 'jev',
    names: ['classify', 'phase', 'recall'],
    title: 'Jev (TypeSafe)',
    text: 'Phase labels next to agents, memory recall in long contexts, and classify workflows in codemode scripts. Needs `TYPESAFE_API_KEY` from console.typesafe.ai; about $0.04 per million input tokens. Transcript excerpts, and memory names with their one-line summaries, leave the machine.',
    recommended: true,
  },
  {
    key: 'parallel',
    names: ['parallel'],
    title: 'Web search (Parallel)',
    text: '`web_search` and `web_fetch` for agents. Needs `PARALLEL_API_KEY` from platform.parallel.ai. Queries, fetched URLs and their objectives leave the machine.',
    aside: 'Or ask Ultimate to build its own web search tool instead.',
    recommended: true,
  },
  { key: 'sounds', names: ['sounds'] },
  { key: 'tailscale', names: ['tailscale'] },
  { key: 'health', names: ['health'] },
  { key: 'cloud', names: ['cloud'] },
]

export const offeredNames = offered.flatMap((offer) => offer.names)

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

export function extensionOptions(
  user: { enable: readonly string[]; disable: readonly string[] },
  changed: Record<string, boolean>,
) {
  const userEnabled = (name: string) =>
    defaultOff.includes(name) ? user.enable.includes(name) : !user.disable.includes(name)
  return offered.map((offer) => ({
    ...offer,
    checked:
      changed[offer.key] ??
      (offer.recommended
        ? !offer.names.some((name) => user.disable.includes(name))
        : offer.names.every(userEnabled)),
  }))
}

export function extensionChoices(
  options: readonly { names: readonly string[]; checked: boolean }[],
) {
  return Object.fromEntries(
    options.flatMap(({ names, checked }) => names.map((name) => [name, checked])),
  )
}
