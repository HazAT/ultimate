import { defineEntry } from '@earendil-works/pi-durable'

/** Recalled memories placed right after the input they apply to. */
export const RecalledEntry = defineEntry<Recalled>('recall.memories')

/**
 * A `recall.memories` entry's data: `input`, the message it answers (the user's prompt, or a branch's report), the root
 * the memories are from, and what was recalled.
 */
export type Recalled = {
  input: number
  root: number
  memories: { slug: string; line: string; confidence: number }[]
}
