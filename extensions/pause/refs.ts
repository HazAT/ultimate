/** Pause in the browser: whether this Ultimate is paused, what still runs, and Pause and Play. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

/**
 * The rate limit that paused Ultimate: the provider and model that answered with it, the error as Pi recorded it,
 * when (ms), and the conversation it first hit. Also the data of the `pause.limit` card in @ultimate's transcript.
 */
export type RateLimit = {
  provider: string
  model: string
  error: string
  at: number
  conversationId: number
}

/**
 * An extension's hold: the extension that asked (its name, e.g. `guard`) and why, one short line saying it; `until`
 * (ms) when what it waits for ends by itself, such as a usage window's reset: the pause then plays shortly after.
 */
export type Hold = { source: string; reason: string; until?: number }

/**
 * The pause on conversation 1: `since` when it began; `runs` each conversation mid-turn then, by id, with its run's
 * generation task and first input submission, so Play notes that run only; `limit` when a rate limit paused it;
 * `held` when an extension held it.
 */
export type PauseDocState = {
  paused: boolean
  since?: number
  runs?: Record<string, { task: number; input?: number }>
  limit?: RateLimit
  held?: Hold
  /** The user pressed Pause, or an extension held without `until`, during this pause: it never plays by itself. */
  manual?: boolean
  /** The user's setting: minutes after a rate-limit pause began that Ultimate presses Play by itself; unset is off. */
  autoPlay?: number
}

/** A task still running while paused: it finishes on its own, nothing new starts after it. */
export type RunningTask = {
  task: number
  conversationId: number
  /** The conversation's label or title. */
  title?: string
  /** `model response`, the tool's name, or the task kind. */
  what: string
  /** When the task first ran (ms). */
  startedAt?: number
}

export type PauseState = {
  paused: boolean
  since?: number
  /** The rate limit that paused Ultimate, if one did. */
  limit?: RateLimit
  /** The extension that held Ultimate, if one did. */
  held?: Hold
  /** Minutes after a rate-limit pause began that Play is pressed by itself; unset is off. */
  autoPlay?: number
  /**
   * When this pause plays by itself (ms): once every cause has an end (a rate limit with the setting on, a hold with
   * `until`), and nothing the user pressed holds it.
   */
  autoPlayAt?: number
  /** Foreground tasks still running: while paused, the pause is safe once this is empty. */
  running: RunningTask[]
}

/** The pause, on conversation 1. */
export const PauseDoc = docRef<PauseDocState>('pause.state')
/** No arguments → the pause and the foreground tasks still running. */
export const StateAction = actionRef<null, PauseState>('pause', 'state')
/**
 * User-only: pause the whole host. Running tasks (a bash call, a model response) finish on their own; no task starts
 * after them, and inputs queue. Survives a restart. Returns the state.
 */
export const PauseAction = actionRef<null, PauseState>('pause', 'pause')
/** User-only: continue. Each run that was mid-turn when paused gets one "Paused for …" note. Returns the state. */
export const PlayAction = actionRef<null, PauseState>('pause', 'play')
/**
 * User-only `{ minutes }`: play by itself that many minutes (1 to 1440) after a rate limit paused Ultimate, once per
 * pause; `null` turns it off. A pause the user pressed never plays by itself. Returns the state.
 */
export const AutoPlayAction = actionRef<{ minutes: number | null }, PauseState>('pause', 'autoPlay')

/**
 * The note Play leaves on a run that was mid-turn: paused from `since` to `until` (ms); `finished` when the run gave
 * its last answer while the pause drained.
 */
export type PauseNote = { since: number; until: number; finished?: boolean; auto?: boolean }

/**
 * The `pause.held` entry in a subagent's parent, mid-turn when the subagent hit a rate limit: subagent `child` hit
 * `provider`'s limit for `model` at `at` (ms), and Ultimate is paused until Play.
 */
export type HeldNote = { child: number; provider: string; model: string; at: number }

/**
 * The `pause.autoplay` entry in @ultimate's transcript: the pause from `since` played by itself at `at`; `minutes` the
 * setting when a rate limit paused it, `held` the hold whose `until` passed.
 */
export type AutoPlayed = { since: number; at: number; minutes?: number; held?: Hold }
