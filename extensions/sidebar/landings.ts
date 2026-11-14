import type { ConversationId } from '@earendil-works/pi-durable'
import type { RootEvent } from '../lineage/types.ts'

/** A landing note of root `root`. */
export type Landing = Extract<RootEvent, { type: 'landed' }> & { root: ConversationId }

/** Landings of one feature (or one untagged title), newest first. */
export type LandingGroup = { label: string; feature?: string; landings: Landing[] }

/** Landings (newest first) by feature, each group placed at its newest landing; untagged ones group by title. */
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

/**
 * The Review range of a group (newest first) when its landings follow each other on the target, each based on the one
 * before; else none, since a range would bring in other features' commits.
 */
export function groupRange(landings: readonly Landing[]) {
  const oldest = landings.at(-1)
  const contiguous = landings.every(
    (landing, index) => index === 0 || landings[index - 1].base === landing.sha,
  )
  return contiguous && oldest?.base ? `${oldest.base}...${landings[0].sha}` : undefined
}
