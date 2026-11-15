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

/**
 * Another project's Ultimate: its project and machine, and `id`, that instance's id of the same message (the sender's
 * for an incoming one, the target's once an outgoing one is delivered).
 */
export type Remote = {
  project: string
  machine: string
  id?: number
  /** The sender's random key for the message: the target delivers it once, and only the target can reply to it. */
  key: string
}
/**
 * An agent's request that later work serves (a branch, an automation): the message the conversation that started it
 * still owed an answer, so the work's result reaches that agent.
 */
export type Serves = { message: number; from: ConversationId | 'remote'; remote?: Remote }

/** A message or reply delivered to a conversation. */
export type DeliveredMessage = {
  id: number
  from: ConversationId | 'user' | 'remote'
  text: string
  reply?: boolean
  re?: number
  routed?: true
  echo?: true
  delivery?: 'note' | 'steer' | 'followUp'
  images?: number
  remote?: Remote
  failed?: boolean
  stopped?: boolean
}

/** Message delivered as a conversation input. */
export const MessageEntry = defineEntry<DeliveredMessage>('board.message')

/** Reply delivered as a conversation input. */
export const ReplyEntry = defineEntry<DeliveredMessage>('board.reply')

/** An automation input delivered to a subscriber or its watcher. */
export type AutomationInput = {
  id: string
  name: string
  text: string
  serves?: Serves
  at?: number
}

/** Fired trigger delivered to a subscriber. */
export const FiredEntry = defineEntry<AutomationInput>('automations.fired')
