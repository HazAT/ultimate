import type { ConversationId } from '@earendil-works/pi-durable'
import type { RootEvent } from '../lineage/types.ts'

export type Landing = Extract<RootEvent, { type: 'landed' }> & { root: ConversationId }

export type LandingGroup = { label: string; feature?: string; landings: Landing[] }

export function groupLandings(landings: readonly Landing[]): LandingGroup[] {
  const groups = new Map<string, LandingGroup>()
  for (const landing of landings) {
    const label = landing.feature ?? landing.title ?? landing.sha.slice(0, 7)
    const group = groups.get(label)
    if (group) group.landings.push(landing)
    else groups.set(label, { label, feature: landing.feature, landings: [landing] })
  }
  return [...groups.values()]
}

export function groupRange(landings: readonly Landing[]) {
  const oldest = landings.at(-1)
  const rangeContainsOnlyThisFeature = landings.every(
    (landing, index) => index === 0 || landings[index - 1].base === landing.sha,
  )
  return rangeContainsOnlyThisFeature && oldest?.base
    ? `${oldest.base}...${landings[0].sha}`
    : undefined
}
