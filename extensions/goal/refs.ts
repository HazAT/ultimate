/** Hands-off goals in the browser: the goal the user put @ultimate on, and every decision it took for them. Browser-safe. */
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** One decision @ultimate took instead of asking the user. */
export type Decision = {
  at: number
  /** What it would have asked the user. */
  question: string
  /** What it chose. */
  picked: string
  reason: string
  /** The branch the decision was for. */
  conversation?: ConversationId
  /** The entry of @ultimate's conversation holding the screenshots it judged, such as a UI preview it approved. */
  images?: EntryId
}

/** How a goal ended: met, blocked (every remaining criterion stuck), or ended by the user. */
export type Ending = {
  at: number
  by: 'user' | 'ultimate'
  outcome: 'met' | 'blocked' | 'ended'
  summary?: string
}

/** What "done" means, as @ultimate wrote it down: each criterion open, met, or blocked after repeated failed tries. */
export type Criterion = { text: string; status: 'open' | 'met' | 'blocked'; tries?: number }

export type Goal = {
  id: number
  /** The user's words: what to reach, and when to stop if they said so. */
  text: string
  startedAt: number
  criteria: Criterion[]
  decisions: Decision[]
  /** The "Goal reminder" automation that wakes @ultimate every 30 minutes while the goal is open. */
  reminder?: string
  /** Set while @ultimate is blocked on the user: the reminder is paused until it resumes. */
  waiting?: { reason: string; at: number }
  ended?: Ending
}

/** `{ next, goals }` on conversation 1, oldest first; at most one goal is open (no `ended`). */
export const GoalDoc = docRef<{ next: number; goals: Goal[] }>('goal')

/** `goal.started` and `goal.report` entries in @ultimate's conversation name their goal. */
export type GoalEntry = { goal: number }

/** `{ text }` → the new goal. User-only: puts @ultimate hands-off on it. */
export const StartAction = actionRef<{ text: string }, Goal>('goal', 'start')
/** No arguments → the ended goal. User-only: ends the open goal; @ultimate asks again as usual. */
export const EndAction = actionRef<null, Goal>('goal', 'end')
/** `{ goal, entry }` → the images of a decision's screenshot entry. */
export const ImagesAction = actionRef<
  { goal: number; entry: EntryId },
  { data: string; mimeType: string }[]
>('goal', 'images')
