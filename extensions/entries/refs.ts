/**
 * Entry kinds that core extensions on both sides of a dependency read: one extension writes them, another renders or
 * routes them, and neither may import the other. Browser-safe.
 */
import { defineEntry } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'

/** A branch abstract: what conversation `conversation` did, as of entry `at`; `anchor` marks a carrier. */
export type AbstractData = {
  conversation: ConversationId
  at: EntryId
  text: string
  title?: string
  feature?: string
  anchor?: EntryId
}

/** A note's data: from another conversation or tally catch-up, or with `source: 'lander'` a landing card's. */
export type NoteData =
  | {
      text: string
      from?: ConversationId
      title?: string
      source?: 'finished' | 'main'
      tally?: EntryId
    }
  | {
      source: 'lander'
      text: string
      from: ConversationId
      at?: number
      divergence?: string
      sha: string
      base?: string
      target: string
      title?: string
      summary?: string
      feature?: string
      commits: { sha: string; subject: string }[]
      paths: string[]
      more: number
      pushed?: string
      abstract?: Omit<AbstractData, 'conversation'>
    }

/** A note received from another conversation, the lander, or tally catch-up. Lineage writes it. */
export const NoteEntry = defineEntry<NoteData>('lineage.note')
