/**
 * The History surface's landing feed: a root's landed events grouped by day, newest first. Browser-safe: pure shaping
 * over the `recent` action's events, no state and no writes.
 */
import type { RootEvent } from './types.ts'

/** A landing as the feed shows it: what landed, in which conversation, and how it diverged. */
export type LandingItem = {
  /** When the landing note was placed, epoch ms. */
  at: number
  /** The landing note's entry in the root, which the row opens when the branch is unknown. */
  entry: number
  title?: string
  feature?: string
  /** The branch that landed it; absent when the note lost it — the row opens the root's note instead. */
  conversation?: number
  divergence?: string
  sha?: string
  commits?: number
  /** The landing's compare link, `base...sha` on the project's GitHub, when `origin` is there and the base is known. */
  compare?: string
}

/** One day's landings, newest first; `label` is `Today`, `Yesterday`, else a short date. */
export type LandingDay = { at: number; label: string; items: LandingItem[] }

/**
 * Groups landed events by calendar day, newest day first, each day's landings newest first. Landings without a time
 * (notes from before landing notes carried one) are skipped: the feed answers what landed when.
 */
export function landingFeed(events: readonly RootEvent[], now: number): LandingDay[] {
  const landed: (Extract<RootEvent, { type: 'landed' }> & { at: number })[] = []
  for (const event of events) {
    if (event.type !== 'landed') continue
    const at = event.at
    if (at === undefined) continue
    landed.push({ ...event, at })
  }
  const days = new Map<string, LandingDay>()
  for (const event of landed.toSorted((a, b) => b.at - a.at)) {
    const date = new Date(event.at)
    const key = date.toDateString()
    let day = days.get(key)
    if (!day) {
      day = { at: event.at, label: dayLabel(date, new Date(now)), items: [] }
      days.set(key, day)
    }
    day.items.push(item(event))
  }
  return [...days.values()].toSorted((a, b) => b.at - a.at)
}

function item(event: Extract<RootEvent, { type: 'landed' }> & { at: number }): LandingItem {
  const { at, entry, title, feature, from, divergence, sha, commits, compare } = event
  return {
    at,
    entry,
    ...(title !== undefined && { title }),
    ...(feature !== undefined && { feature }),
    ...(from !== undefined && { conversation: from }),
    ...(divergence !== undefined && { divergence }),
    ...(sha !== undefined && { sha }),
    ...(commits !== undefined && { commits }),
    ...(compare !== undefined && { compare }),
  }
}

/** `Today`, `Yesterday`, else the short date, with the year when it is not the current one. */
function dayLabel(date: Date, today: Date): string {
  if (date.toDateString() === today.toDateString()) return 'Today'
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return date.getFullYear() === today.getFullYear() ? label : `${label}, ${date.getFullYear()}`
}
