/**
 * Workspaces in the browser: the worktree index every conversation's isolate and the lander queue live in, the actions
 * that inspect worktrees, and the landing event. Browser-safe.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type {
  GithubRepo,
  WorkspaceDisk,
  WorkspaceIndex,
  WorkspaceInfo,
  WorkspaceStats,
} from './types.ts'
import type { KeptWork } from '../conversations/types.ts'

/** Why the project cannot isolate conversations (`reason`, absent when it can), and whether its folder is empty. */
export type Isolation = { reason?: string; empty?: boolean }

/** The worktree index on the root conversation: each conversation's isolate, the lander queue and recent outcomes. */
export const WorkspacesDoc = docRef<WorkspaceIndex>('ultimate.workspaces')

/** `{ id }` → conversation `id`'s worktree with its branch, tip and changes, or null when it has none. */
export const InfoAction = actionRef<{ id: number }, WorkspaceInfo | null>('workspaces', 'info')
/**
 * `{ ids }` → the work so far of these conversations' ready worktrees: commits not yet on their target and uncommitted
 * changes, one entry per id that has a worktree, for the sidebar's in-flight rows.
 */
export const ProgressAction = actionRef<{ ids: number[] }, KeptWork[]>('workspaces', 'progress')
/** `{ ids }` → the unlanded work of these conversations' worktrees, to warn before concluding them. */
export const PendingAction = actionRef<{ ids: number[] }, KeptWork[]>('workspaces', 'pending')
/** No arguments → how many worktrees there are in total and in each state, for the workspaces panel. */
export const StatsAction = actionRef<null, WorkspaceStats>('workspaces', 'stats')
/** No arguments → the disk space the worktrees take (on btrfs also with shared blocks counted once), at most a minute old. */
export const DiskAction = actionRef<null, WorkspaceDisk>('workspaces', 'disk')
/**
 * No arguments → whether the project can start isolated conversations; once it can, the project's lander is stood up
 * if it has none.
 */
export const IsolationAction = actionRef<null, Isolation>('workspaces', 'isolation')
/** No arguments → `github.com/<owner>/<repo>` of the project's `origin`, or null off GitHub. */
export const GithubAction = actionRef<null, string | null>('workspaces', 'github')
export type { GithubRepo }
/** No arguments → the project's `origin` on GitHub with its visibility, or null off GitHub. */
export const RepoAction = actionRef<null, GithubRepo | null>('workspaces', 'repo')

export type LandedData = {
  /** The submission's id in the lander's queue. */
  submission: string
  /** The submitting conversation, and its latest entry when it submitted. */
  conversationId: number
  at: number
  /** The target's new tip, the tip it moved from, and the branch. */
  sha: string
  base: string
  target: string
  /** The lander conversation that landed it. */
  lander: number
  divergence: string
  /** The submitter's title and summary as they were at submit time. */
  title: string
  summary?: string
  feature?: string
  /** The first ten commits it brought, newest first, out of `commitCount`; the first eight changed paths. */
  commits: { sha: string; subject: string }[]
  commitCount: number
  paths: string[]
  /** `<remote>/<target>` it was pushed to; absent when not pushed or the push failed. */
  pushed?: string
}
/**
 * The lander landed a submission: the target moved to `sha`. Emitted in the commit that records the outcome, also when
 * only the push failed afterwards; react to it for anything that must follow every landing exactly once.
 */
export const SubmissionLanded = defineEvent<LandedData>('workspaces.landed')
/**
 * The lander gave up on submission `submission` of `conversationId` without landing it, for `reason`. Emitted in the
 * commit that records the outcome; it fails `workspaces.landed`, so a wait on that ends with it.
 */
export const SubmissionFailed = defineEvent<{
  submission: string
  conversationId: number
  target: string
  reason: string
}>('workspaces.landing-failed', { fails: 'workspaces.landed' })
/**
 * The lander ran check `command` on submission `submission`: `passed`, `failed`, `flaky` (its rerun passed) or `timeout`
 * (a watchdog stopped it), taking `ms`. Once per run, the rerun too, in the commit that logs its result; a crash
 * before that commit runs the check again, as the lander log shows it.
 */
export const CheckRan = defineEvent<{
  submission: string
  command: string
  result: 'passed' | 'failed' | 'flaky' | 'timeout'
  ms: number
}>('workspaces.check')
