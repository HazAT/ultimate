/**
 * Workspaces: isolated Git worktrees for conversations and the lander that merges them into their target branch.
 * Other extensions create, look up, land and discard a conversation's worktree through this service.
 */
import type { Context } from '@earendil-works/chord/context'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { git } from '../../lib/git.ts'
import type { Workspaces, workspaces } from './workspaces.ts'

type Implementation = ReturnType<typeof workspaces>

export type WorkspaceService = {
  /** The worktree of conversation `id` (path, branch, target, state), or undefined when it has none. */
  get: Implementation['get']
  /** Give conversation `id` a new worktree of `cwd`'s repository inside `tx`; throws when `cwd` cannot be isolated. */
  create: Implementation['create']
  /** Fast-forward the worktree of `id`'s owner to the worktree tip of subagent `id`; returns what landed. */
  land: Implementation['land']
  /** Remove the worktree of `id` without landing it. */
  discard: Implementation['discard']
  /** Free the worktrees of concluded conversations `ids` and their descendants; returns the ones kept (busy, unlanded). */
  release: Implementation['release']
  /** Run `git` with `args` in a directory; rejects with Git's message. Use it instead of spawning Git yourself. */
  git: typeof git
  /** The worktree index document (`ultimate.workspaces` on the root), for reads inside a transaction. */
  doc: typeof Workspaces
  /** Make the project folder a Git repository with a first commit, so worktrees and landing work. */
  setupGit(): Promise<void>
}
/** Worktrees and landing; core, so `need` it. */
export const WorkspacesApi = defineApi<WorkspaceService>()('workspaces')

export { CheckRan, SubmissionFailed, SubmissionLanded } from './refs.ts'
export type { LandedData } from './refs.ts'
export type BranchesService = {
  /** The conversation that started branch `id`, which hears that its submission landed. */
  starter(id: ConversationId, ctx: Context): Promise<number | undefined>
  /** Inside `tx`: whether branch `id` has work of its own that will wake it again, so a landing leaves it open. */
  working(tx: Tx, id: ConversationId): Promise<boolean>
}
/** What a landing asks about the branch it landed; messages provides it. `want` it. */
export const Branches = defineApi<BranchesService>()('workspaces.branches')
export const tier = 'core'
