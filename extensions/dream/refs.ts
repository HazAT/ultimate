/** Dream in the browser: the prepared next chapter, the sleep into it and the chapters. Browser-safe. */
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import type { Seed } from './types.ts'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/**
 * What @ultimate prepared for the next chapter once its dream's work was done: the chapter's name, three lines it
 * learned, and its handover, which the new chapter wakes up from.
 */
export type Prepared = { chapter: string; learned: string[]; handoff: string; at: number }

export type Sleep = {
  chapter: string
  /** `asleep`: the switch happened; this chapter is the one it left. */
  phase: 'seeding' | 'backing up' | 'switching' | 'asleep' | 'failed'
  backup?: { id?: string; skipped?: string }
  error?: string
  at: number
}

/**
 * The latest dream: `branch`, the branch @ultimate started in the turn that answered `requested` (its `dream.requested`
 * entry), at `at`. Once the branch is concluded the user is shown Fall asleep; `asked` when they pressed it (@ultimate
 * prepares then), `dismissed` when they chose to stay in this chapter.
 */
export type Dream = {
  branch: ConversationId
  requested: EntryId
  at: number
  asked?: number
  dismissed?: true
}

/**
 * `{ prepared?, sleep?, dream? }` on conversation 1: the next chapter @ultimate prepared, the sleep into it, and the
 * latest dream.
 */
export const DreamDoc = docRef<{ prepared?: Prepared; sleep?: Sleep; dream?: Dream }>('dream.next')

/**
 * A `dream.requested` entry in @ultimate's conversation: who asked for the dream, the user's Dream button or a
 * built-in automation (`pause`: how long the user had been away, ms).
 */
export type RequestedEntry = { automation?: { id: string; name: string; pause?: number } }

/** The new chapter's first card, including what was carried over. */
export type ChapterEntry = {
  from: { name: string; number: number }
  number: number
  name: string
  learned?: string[]
  carried?: Seed['counts']
}

/** No arguments: ask @ultimate to dream now. User-only. */
export const StartAction = actionRef<null, { requested: true }>('dream', 'start')
/** No arguments: the user pressed Fall asleep after the dream; @ultimate is asked to prepare the chapter. User-only. */
export const ReadyAction = actionRef<null, { asked: number }>('dream', 'ready')
/** No arguments: the user stays in this chapter; the dream's Fall asleep cue goes. User-only. */
export const DismissAction = actionRef<null, { dismissed: true }>('dream', 'dismiss')
/**
 * `{ chapter, learned, handoff }`: @ultimate prepares the next chapter and puts the Fall asleep card up; a second call
 * replaces it.
 */
export const PrepareAction = actionRef<
  { chapter: string; learned: string[]; handoff: string },
  Prepared
>('dream', 'prepare')
/** `{ name? }` → progress: seed, back up and restart into the prepared chapter. User-only. */
export const AsleepAction = actionRef<{ name?: string }, { sleep: Sleep }>('dream', 'asleep')
/** No arguments → the active chapter, its number, the newest name, and every chapter in creation order. */
export const ChaptersAction = actionRef<
  null,
  {
    active: string
    number: number
    newest: string
    chapters: { name: string; number: number; createdAt?: number }[]
  }
>('dream', 'chapters')
/** `{ chapter }`: restart into an existing, idle chapter. User-only; a returned error means restart failed. */
export const SwitchAction = actionRef<{ chapter: string }, never>('dream', 'switch')

/** Calls and failures grouped by one side of the call (an extension, or `agent`), most calls first. */
export type CallCounts = {
  byCaller: { name: string; calls: number; failed: number }[]
  byCallee: { name: string; calls: number; failed: number }[]
}

/** Calls per tool over the window: how often, how often failing, how slow; enabled tools never called; and service and action calls per caller and per callee. `since`/`until` are the first and last tool call in it. */
export type ToolStats = {
  since?: number
  until?: number
  calls: number
  tools: { name: string; calls: number; failed: number; avgMs: number }[]
  unused: string[]
  /** The most frequent errors, each with its two newest calls: `#<conversation>/<entry>` and the start of its args. */
  errors: {
    name: string
    error: string
    count: number
    examples: { at: string; args: string }[]
  }[]
  services: CallCounts
  actions: CallCounts
}
/** `{ since?, until? }` (both inclusive; an ISO time with `Z` or an offset, or a date alone for its UTC midnight; default the chapter's whole trace) → call statistics from `trace.sqlite`, no model involved. */
export const StatsAction = actionRef<{ since?: string; until?: string } | null, ToolStats>(
  'dream',
  'stats',
)
