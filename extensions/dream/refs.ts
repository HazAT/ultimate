/** Dream sessions in the browser: the passes, the journal and the proposals followed to landing. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { PassName } from './types.ts'

export type { PassName } from './types.ts'
export type PassState = { status: 'waiting' | 'running' | 'done' | 'failed'; note?: string }

/**
 * One proposal from a pass. `open` until @ultimate records the user's decision: `approved` with the branch that does it,
 * `applied` for a memory change made at once, `rejected`; an approved branch becomes `landed` with its sha, or `applied`
 * with a `reason` naming files it wrote outside git. `retire` is
 * the memory slug a codified proposal makes redundant once it lands.
 */
export type Proposal = {
  id: string
  pass: PassName
  title: string
  size?: string
  risk?: string
  retire?: string
  status: 'open' | 'approved' | 'rejected' | 'applied' | 'landed'
  branch?: number
  sha?: string
  /** Why @ultimate decided it in the user's place (a hands-off goal), or what an approved proposal wrote when applied. */
  reason?: string
}

/** What the dream learned: three lines in @ultimate's voice, then the journal in Markdown. */
export type Journal = { learned: string[]; text: string; chapter?: string; at: number }

export type GateResult = { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }
export type Sleep = {
  chapter: string
  /** `asleep`: the switch happened; this session's chapter is the one it left. */
  phase: 'seeding' | 'checking' | 'backing up' | 'switching' | 'asleep' | 'failed'
  checks?: GateResult['checks']
  backup?: { id?: string; skipped?: string }
  error?: string
  at: number
}

export type Session = {
  id: number
  startedAt: number
  /** The dream coordinator's branch, from its first pass report. */
  dreamer?: number
  passes: Record<PassName, PassState>
  journal?: Journal
  sleep?: Sleep
  proposals: Proposal[]
  /** Every proposal settled, or the user ended the session. */
  endedAt?: number
  /** Set when the built-in "Dream before compaction" automation started this session. */
  beforeCompaction?: BeforeCompaction
  /**
   * @ultimate's handoff, the dream's primary input, from the handoff request (`task`, its wait) that started this
   * session: its `text`, or why there is none (`missing`).
   */
  handoff?: Handoff
}

export type Handoff = { task: number; text?: string; at?: number; missing?: string }

/**
 * A dream waiting for @ultimate's handoff and then for every other conversation to finish: asked at `at` by the
 * built-in `automation`'s fire, or by the user's Dream button (no `automation`); `task` is the wait. `handoff` once
 * @ultimate recorded it; `gaveUp` once two hours passed, until the note saying so is left.
 */
export type Waiting = {
  at: number
  task: number
  /**
   * Time (ms) the wait could not look, its host paused or down: its deadlines count from `at` plus this, so a Pause
   * or a restart does not use them up.
   */
  unseen?: number
  gaveUp?: true
  /** `pause`: how long the user had been away (ms) when "Dream after a pause" fired. */
  automation?: { id: string; name: string; pause?: number }
  handoff?: { text: string; at: number }
}

/**
 * A dream that the built-in automation `automation` (`name`) started at `at`, once @ultimate's context passed its
 * threshold. `settling` is the task that checks the settled session; `outcome` records whether it was worth a fresh
 * chapter: `changes` (landed and applied proposals) against `threshold`; `stay` in this chapter, or `ask` the user to
 * Fall asleep. `pause` (ms) when "Dream after a pause" started it: the user was away that long, and it always asks.
 */
export type BeforeCompaction = {
  automation: string
  name: string
  at: number
  pause?: number
  settling?: number
  outcome?: { changes: number; threshold: number; result: 'stay' | 'ask'; at: number }
}

/** `{ next, sessions, waiting? }` on conversation 1, sessions oldest first. */
export const DreamDoc = docRef<{ next: number; sessions: Session[]; waiting?: Waiting }>(
  'dream.sessions',
)

/** `dream.started`, `dream.journal` and `dream.settled` entries in @ultimate's conversation name their session. */
export type SessionEntry = { session: number }
/** A `dream.handoff` entry asks @ultimate for its handoff: `task` is the request's wait. */
export type HandoffEntry = { task: number; automation?: Waiting['automation'] }

/**
 * No arguments → `{ task }`: ask @ultimate for its handoff; the dream starts once it is recorded (or after 30 minutes)
 * and nothing else works. User-only.
 */
export const StartAction = actionRef<null, { task: number }>('dream', 'start')
/** `{ text }` → `{ task }`: @ultimate records its handoff for the dream that waits for it (at most 12,000 characters). */
export const HandoffAction = actionRef<{ text: string }, { task: number }>('dream', 'handoff')
/** `{ session }` → `{ session }`: end a session whatever its proposals' state. User-only. */
export const EndAction = actionRef<{ session: number }, { session: number }>('dream', 'end')
/** `{ session, pass, status, note? }`: the dream coordinator reports a pass; its first report names it the dreamer. */
export const PassAction = actionRef<
  { session: number; pass: PassName; status: PassState['status']; note?: string },
  { session: number }
>('dream', 'pass')
/** `{ session, learned, text, proposals }`: file the journal and show its card in @ultimate's conversation, once. */
export const JournalAction = actionRef<
  {
    session: number
    learned: string[]
    text: string
    chapter?: string
    proposals: Pick<Proposal, 'id' | 'pass' | 'title' | 'size' | 'risk' | 'retire'>[]
  },
  { session: number; proposals: number }
>('dream', 'journal')
/** `{ session, name? }` → progress: seed, check, back up and restart into a fresh chapter. User-only. */
export const AsleepAction = actionRef<
  { session: number; name?: string },
  { session: number; sleep: Sleep }
>('dream', 'asleep')
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
/**
 * `{ session, proposal, status, branch?, sha?, repo?, reason? }`: @ultimate records the user's decision on one proposal,
 * or its own with `reason` when it decides in the user's place (a hands-off goal). `landed` settles an approved proposal
 * merged outside a workspace: `sha` must be reachable from HEAD in `repo` (default the project folder). Approved →
 * `applied` needs `reason` naming what was written. An ended session accepts only approved → rejected, applied or landed.
 * Returns the proposal.
 */
export const DecideAction = actionRef<
  {
    session: number
    proposal: string
    status: 'approved' | 'rejected' | 'applied' | 'landed'
    branch?: number
    sha?: string
    repo?: string
    reason?: string
  },
  Proposal
>('dream', 'decide')

/** Calls per tool over the trace's window: how often, how often failing, how slow; and enabled tools never called. */
export type ToolStats = {
  since?: number
  calls: number
  tools: { name: string; calls: number; failed: number; avgMs: number }[]
  unused: string[]
  errors: { name: string; error: string; count: number }[]
}
/** No arguments → tool statistics from `trace.sqlite`, no model involved. */
export const StatsAction = actionRef<null, ToolStats>('dream', 'stats')
