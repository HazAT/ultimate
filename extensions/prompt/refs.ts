/** Prompt in the browser: the note on an input that says what changed since the conversation's last run. Browser-safe. */
import type { ConversationId } from '@earendil-works/pi-durable'

/** A landing a build brought: the branch `conversation` (absent for a commit made outside Ultimate) and its title. */
export type Landing = {
  conversation?: ConversationId
  title: string
  sha: string
}

/** A `prompt.build` entry's data: a build change, and the instruction files that changed for the primary agent. */
export interface BuildNote {
  from?: string
  to?: string
  /** What landed in the clone between the two builds, newest first: one row per branch, its title and newest commit. */
  landed?: Landing[]
  /** Agent definitions whose instructions were re-applied. */
  instructions?: string[]
  /** Project context files and Ultimate's docs that changed. */
  docs?: string[]
}
