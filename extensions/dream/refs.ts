/** Dream in the browser: the prepared next chapter, the sleep into it and the chapters. Browser-safe. */
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
  branch: number
  requested: number
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

/** Calls per tool over the trace's window: how often, how often failing, how slow; and enabled tools never called. */
export type ToolStats = {
  since?: number
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
}
/** No arguments → tool statistics from `trace.sqlite`, no model involved. */
export const StatsAction = actionRef<null, ToolStats>('dream', 'stats')
